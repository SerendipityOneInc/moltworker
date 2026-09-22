/**
 * Shared test utilities for mocking sandbox and environment
 */
import { vi } from 'vitest';
import type { Sandbox, Process, ExecResult } from '@cloudflare/sandbox';
import type { OpenClawEnv } from './types';

export function createMockEnv(overrides: Partial<OpenClawEnv> = {}): OpenClawEnv {
  return {
    Sandbox: {} as any,
    ASSETS: {} as any,
    BACKUP_BUCKET: {} as any,
    ...overrides,
  };
}

export function createMockEnvWithR2(overrides: Partial<OpenClawEnv> = {}): OpenClawEnv {
  return createMockEnv({
    R2_ACCESS_KEY_ID: 'test-key-id',
    R2_SECRET_ACCESS_KEY: 'test-secret-key',
    CLOUDFLARE_ACCOUNT_ID: 'test-account-id',
    BACKUP_BUCKET_NAME: 'moltbot-data',
    ...overrides,
  });
}

export function createMockProcess(
  stdout: string = '',
  options: { exitCode?: number; stderr?: string; status?: string } = {},
): Partial<Process> {
  const { exitCode = 0, stderr = '', status = 'completed' } = options;
  return {
    status: status as Process['status'],
    exitCode,
    getLogs: vi.fn().mockResolvedValue({ stdout, stderr }),
  };
}

export function createMockExecResult(
  stdout: string = '',
  options: { exitCode?: number; stderr?: string; success?: boolean } = {},
): ExecResult {
  return {
    stdout,
    stderr: options.stderr ?? '',
    exitCode: options.exitCode ?? 0,
    success: options.success ?? (options.exitCode ?? 0) === 0,
    command: '',
    duration: 0,
    timestamp: new Date().toISOString(),
  };
}

export interface MockSandbox {
  sandbox: Sandbox;
  startProcessMock: ReturnType<typeof vi.fn>;
  listProcessesMock: ReturnType<typeof vi.fn>;
  containerFetchMock: ReturnType<typeof vi.fn>;
  execMock: ReturnType<typeof vi.fn>;
  writeFileMock: ReturnType<typeof vi.fn>;
}

export function createMockSandbox(
  options: {
    processes?: Partial<Process>[];
  } = {},
): MockSandbox {
  const listProcessesMock = vi.fn().mockResolvedValue(options.processes || []);
  const containerFetchMock = vi.fn();
  const startProcessMock = vi.fn().mockResolvedValue(createMockProcess());
  const execMock = vi.fn().mockResolvedValue(createMockExecResult());
  const writeFileMock = vi.fn().mockResolvedValue(undefined);

  const sandbox = {
    listProcesses: listProcessesMock,
    startProcess: startProcessMock,
    containerFetch: containerFetchMock,
    exec: execMock,
    writeFile: writeFileMock,
    wsConnect: vi.fn(),
  } as unknown as Sandbox;

  return {
    sandbox,
    startProcessMock,
    listProcessesMock,
    containerFetchMock,
    execMock,
    writeFileMock,
  };
}

export function suppressConsole() {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
}

interface StoredObject {
  body: Uint8Array;
  uploaded: Date;
}

/**
 * Minimal in-memory R2Bucket supporting get/head/put/delete/list.
 * `objects` is exposed so tests can seed or inspect contents directly.
 */
function toMockR2Object(key: string, stored: StoredObject) {
  return {
    key,
    size: stored.body.byteLength,
    uploaded: stored.uploaded,
    text: async () => new TextDecoder().decode(stored.body),
    json: async () => JSON.parse(new TextDecoder().decode(stored.body)),
    arrayBuffer: async () => stored.body.slice().buffer,
  };
}

export function createMockBucket(now: () => Date = () => new Date()) {
  const objects = new Map<string, StoredObject>();
  const toObject = toMockR2Object;

  const bucket = {
    get: vi.fn(async (key: string) => {
      const stored = objects.get(key);
      return stored ? toObject(key, stored) : null;
    }),
    head: vi.fn(async (key: string) => {
      const stored = objects.get(key);
      return stored ? toObject(key, stored) : null;
    }),
    put: vi.fn(async (key: string, value: string | ArrayBuffer | Uint8Array) => {
      const body =
        typeof value === 'string'
          ? new TextEncoder().encode(value)
          : new Uint8Array(value instanceof Uint8Array ? value : new Uint8Array(value));
      objects.set(key, { body, uploaded: now() });
      return toObject(key, objects.get(key)!);
    }),
    delete: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    }),
    list: vi.fn(async (options: { prefix?: string } = {}) => ({
      objects: [...objects.entries()]
        .filter(([key]) => key.startsWith(options.prefix ?? ''))
        .map(([key, stored]) => toObject(key, stored)),
      truncated: false,
    })),
  };

  return { bucket: bucket as unknown as R2Bucket, objects, mocks: bucket };
}

/** Store a JSON value directly in a mock bucket's contents */
export function seedJson(
  objects: Map<string, StoredObject>,
  key: string,
  value: unknown,
  uploaded: Date = new Date(),
) {
  objects.set(key, { body: new TextEncoder().encode(JSON.stringify(value)), uploaded });
}
